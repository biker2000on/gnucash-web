import { ContactManager } from '@/components/business/ContactManager';
import { product } from '@/lib/product';

export const metadata = {
    title: `Customers - ${product.brand}`,
};

export default function CustomersPage() {
    return <ContactManager kind="customer" enableStatements />;
}
