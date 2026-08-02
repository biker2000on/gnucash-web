import prisma from '@/lib/prisma';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import {
  getDocumentBySource,
  updateDocumentExtraction,
  upsertDocument,
} from './service';

export interface GenericDocumentSuggestions {
  documentClass: string | null;
  effectiveDates: string[];
  parties: string[];
  referenceNumbers: string[];
}

function cleanStrings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim().slice(0, maxLength)] : [])
    .slice(0, maxItems);
}

/** Parse and bound generic AI suggestions before persisting them. */
export function parseGenericDocumentSuggestions(raw: string): GenericDocumentSuggestions {
  // Lazy-free pure parser makes the persistence boundary independently testable.
  const match = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI response was not a JSON object');
  const value = JSON.parse(match[0]) as Record<string, unknown>;
  const documentClass = typeof value.document_class === 'string' && value.document_class.trim()
    ? value.document_class.trim().slice(0, 80)
    : null;
  return {
    documentClass,
    effectiveDates: cleanStrings(value.effective_dates, 12, 10)
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
    parties: cleanStrings(value.parties, 20, 160),
    referenceNumbers: cleanStrings(value.reference_numbers, 20, 80),
  };
}

export function buildGenericDocumentSuggestionPrompt(text: string): string {
  return `Review the document text below and return ONLY JSON with: document_class (short string or null), effective_dates (array of YYYY-MM-DD strings), parties (array of people/organizations), and reference_numbers (array of identifiers). Do not infer values that are not present. Keep each array under 20 items.\n\n${text.slice(0, 20_000)}`;
}

/**
 * Extract searchable text from a vault document. This deliberately stops at
 * OCR/text indexing: it never writes inferred dates, types, or other business
 * fields back to the specialised entity-document row.
 */
export async function runEntityDocumentExtraction(
  documentId: number,
  bookGuid: string,
  logPrefix = '[entity-document]',
): Promise<void> {
  const row = await prisma.gnucash_web_entity_documents.findFirst({
    where: { id: documentId, book_guid: bookGuid },
  });
  if (!row) {
    console.warn(`${logPrefix} Entity document ${documentId} not found in book, skipping`);
    return;
  }

  let canonical = await getDocumentBySource(bookGuid, 'entity_document', String(documentId));
  if (!canonical) {
    canonical = await upsertDocument({
      bookGuid,
      title: row.title,
      storageKey: row.file_key,
      filename: row.file_name ?? row.title,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      extractionStatus: 'pending',
      extractedText: row.notes,
      extractionMetadata: { docType: row.doc_type, notes: row.notes },
      sourceKind: 'entity_document',
      sourceId: String(documentId),
    });
  }

  await updateDocumentExtraction(bookGuid, canonical.id, {
    status: 'processing',
    text: canonical.extractedText,
    metadata: canonical.extractionMetadata,
  });

  try {
    if (!row.file_key) throw new Error('Document has no stored file');
    const storage = await getStorageBackend();
    const buffer = await storage.get(row.file_key);
    let text = '';
    if (row.mime_type === 'application/pdf') {
      const { extractTextFromPdf } = await import('@/lib/pdf-text-extract');
      text = await extractTextFromPdf(buffer);
    } else if (row.mime_type?.startsWith('image/')) {
      const { extractTextFromImage } = await import('@/lib/queue/jobs/ocr-receipt');
      text = await extractTextFromImage(buffer);
    }

    let suggestionMetadata: Record<string, unknown> = {};
    if (canonical.ownerUserId != null) {
      const { getAiConfig } = await import('@/lib/ai-config');
      const aiConfig = await getAiConfig(canonical.ownerUserId);
      if (aiConfig?.enabled && aiConfig.base_url && aiConfig.model) {
        try {
          if (row.doc_type === 'insurance') {
            const { extractInsurancePolicyDocument } = await import('@/lib/resilience/insurance-parse');
            suggestionMetadata = {
              suggestionKind: 'insurance_policy',
              suggestions: await extractInsurancePolicyDocument({
                buffer,
                mimeType: row.mime_type ?? 'application/octet-stream',
                aiConfig,
              }),
            };
          } else if (row.doc_type === 'estate') {
            const { extractEstateDocument } = await import('@/lib/resilience/estate-parse');
            suggestionMetadata = {
              suggestionKind: 'estate_document',
              suggestions: await extractEstateDocument({
                buffer,
                mimeType: row.mime_type ?? 'application/octet-stream',
                aiConfig,
              }),
            };
          } else if (text.trim()) {
            const { chatComplete } = await import('@/lib/ai-query/client');
            const reply = await chatComplete(aiConfig, [
              { role: 'user', content: buildGenericDocumentSuggestionPrompt(text) },
            ], { maxTokens: 900, timeoutMs: 60_000 });
            suggestionMetadata = {
              suggestionKind: 'generic_document',
              suggestions: parseGenericDocumentSuggestions(reply),
            };
          }
        } catch (suggestionError) {
          // OCR remains useful even if optional AI suggestions fail.
          suggestionMetadata = {
            suggestionError: (suggestionError instanceof Error
              ? suggestionError.message
              : String(suggestionError)).slice(0, 500),
          };
        }
      }
    }

    await updateDocumentExtraction(bookGuid, canonical.id, {
      status: 'completed',
      text: text.trim() || row.notes,
      metadata: {
        ...(canonical.extractionMetadata ?? {}),
        extraction: 'ocr',
        characterCount: text.trim().length,
        ...suggestionMetadata,
      },
      error: null,
      extractedAt: new Date(),
    });
  } catch (error) {
    await updateDocumentExtraction(bookGuid, canonical.id, {
      status: 'failed',
      text: canonical.extractedText,
      metadata: canonical.extractionMetadata,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
