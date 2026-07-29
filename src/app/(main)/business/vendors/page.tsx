import { ContactManager } from '@/components/business/ContactManager';
import { product } from '@/lib/product';

export const metadata = {
    title: `Vendors - ${product.brand}`,
};

export default function VendorsPage() {
    return <ContactManager kind="vendor" />;
}
