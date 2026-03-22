import { ReceiptGallery } from '@/components/receipts/ReceiptGallery';

export default function ReceiptsPage() {
  return (
    <div className="p-4 md:p-6">
      <h1 className="text-2xl font-semibold text-foreground mb-6">Receipts</h1>
      <ReceiptGallery />
    </div>
  );
}
