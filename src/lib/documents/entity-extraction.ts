import prisma from '@/lib/prisma';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import type { PdfTextSource } from '@/lib/pdf-text-extract';
import {
  TAX_FORM_DEFINITIONS,
  isValidTaxForm,
  isValidTaxYear,
} from '@/lib/entity-document-context';
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

export interface TaxRecordSuggestions {
  /** One of TAX_FORM_DEFINITIONS values, or null when the AI could not tell. */
  taxForm: string | null;
  taxYear: number | null;
  issuer: string | null;
}

/**
 * Parse and bound AI tax-record suggestions. Values outside the allowed
 * form vocabulary or plausible year range are dropped, never guessed.
 */
export function parseTaxRecordSuggestions(raw: string): TaxRecordSuggestions {
  const match = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI response was not a JSON object');
  const value = JSON.parse(match[0]) as Record<string, unknown>;
  const taxYearRaw = typeof value.tax_year === 'string' ? parseInt(value.tax_year, 10) : value.tax_year;
  return {
    taxForm: isValidTaxForm(value.tax_form) ? value.tax_form : null,
    taxYear: isValidTaxYear(taxYearRaw) ? taxYearRaw : null,
    issuer: typeof value.issuer === 'string' && value.issuer.trim()
      ? value.issuer.trim().slice(0, 255)
      : null,
  };
}

export function buildTaxRecordSuggestionPrompt(text: string): string {
  const vocabulary = TAX_FORM_DEFINITIONS
    .map(({ value, label }) => `${value} (${label})`)
    .join(', ');
  return `The document text below is a tax record (e.g. a W-2, 1099, 1098, 5498, K-1, filed return, or IRS/state notice). Return ONLY JSON with: tax_form (one of: ${vocabulary}; null if unclear), tax_year (the tax year the form reports on, as a number — NOT the year it was mailed; null if unclear), and issuer (the institution or employer that issued the form, e.g. "Fidelity" or "Acme Corp"; null if unclear). Do not infer values that are not present in the text.\n\n${text.slice(0, 20_000)}`;
}

export function buildGenericDocumentSuggestionPrompt(text: string): string {
  return `Review the document text below and return ONLY JSON with: document_class (short string or null), effective_dates (array of YYYY-MM-DD strings), parties (array of people/organizations), and reference_numbers (array of identifiers). Do not infer values that are not present. Keep each array under 20 items.\n\n${text.slice(0, 20_000)}`;
}

/**
 * Extract searchable text from a vault document. This deliberately stops at
 * OCR/text indexing: it never writes inferred dates, types, or other business
 * fields back to the specialised entity-document row. Scanned PDFs fall back to
 * OCR; a document that yields no text ends as `failed` (or `not_applicable` for
 * file types with no extractor) rather than as a completed empty index.
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
    const mimeType = row.mime_type ?? 'application/octet-stream';
    let text = '';
    let textSource: PdfTextSource | 'unsupported' = 'unsupported';
    let extractionError: string | null = null;

    if (row.mime_type === 'application/pdf') {
      const { extractPdfText } = await import('@/lib/pdf-text-extract');
      const extracted = await extractPdfText(buffer, {
        // Imported lazily so PDFs that carry a text layer never load tesseract.
        ocr: async (pdf) => {
          const { extractTextFromPdfViaOcr } = await import('@/lib/queue/jobs/ocr-receipt');
          return extractTextFromPdfViaOcr(pdf);
        },
      });
      text = extracted.text;
      textSource = extracted.source;
      extractionError = extracted.ocrError;
    } else if (row.mime_type?.startsWith('image/')) {
      const { extractTextFromImage } = await import('@/lib/queue/jobs/ocr-receipt');
      text = (await extractTextFromImage(buffer)).trim();
      textSource = text ? 'ocr' : 'none';
      extractionError = text ? null : `OCR produced no text for ${mimeType}`;
    } else {
      extractionError = `No text extractor for ${mimeType}`;
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
          } else if (row.doc_type === 'tax' && text.trim()) {
            const { chatComplete } = await import('@/lib/ai-query/client');
            const reply = await chatComplete(aiConfig, [
              { role: 'user', content: buildTaxRecordSuggestionPrompt(text) },
            ], { maxTokens: 400, timeoutMs: 60_000 });
            suggestionMetadata = {
              suggestionKind: 'tax_record',
              suggestions: parseTaxRecordSuggestions(reply),
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

    const extractedText = text.trim();
    const metadata = {
      ...(canonical.extractionMetadata ?? {}),
      extraction: 'ocr',
      textSource,
      characterCount: extractedText.length,
      ...(extractionError ? { extractionError } : {}),
      ...suggestionMetadata,
    };

    if (!extractedText) {
      // Explicit failure state: an unextractable file stays visible as failed
      // instead of being recorded as a completed index over empty text.
      await updateDocumentExtraction(bookGuid, canonical.id, {
        status: textSource === 'unsupported' ? 'not_applicable' : 'failed',
        text: row.notes,
        metadata,
        error: extractionError,
      });
      return;
    }

    await updateDocumentExtraction(bookGuid, canonical.id, {
      status: 'completed',
      text: extractedText,
      metadata,
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
