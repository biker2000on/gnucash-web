import { ContactManager } from '@/components/business/ContactManager';

export const metadata = {
    title: 'Vendors - GnuCash Web',
};

export default function VendorsPage() {
    return <ContactManager kind="vendor" />;
}
