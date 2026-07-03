'use client';

import { Modal } from '@/components/ui/Modal';
import NewBookForm from '@/components/books/NewBookForm';

interface NewBookWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (bookGuid: string) => void;
}

/**
 * New-book modal used by the book switcher. Delegates to the shared
 * NewBookForm: pick an organization type, name the book, and create it
 * seeded with the recommended account hierarchy.
 */
export default function NewBookWizard({ isOpen, onClose, onSuccess }: NewBookWizardProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Book" size="lg">
      <div className="p-6">
        <NewBookForm
          onSuccess={onSuccess}
          onCancel={onClose}
          showDescription
        />
      </div>
    </Modal>
  );
}
