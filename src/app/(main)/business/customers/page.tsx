import { ContactManager } from '@/components/business/ContactManager';

export const metadata = {
    title: 'Customers - GnuCash Web',
};

export default function CustomersPage() {
    return <ContactManager kind="customer" />;
}
