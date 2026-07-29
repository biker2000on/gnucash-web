import { MembershipManager } from '@/components/membership/MembershipManager';
import { product } from '@/lib/product';

export const metadata = {
    title: `Members - ${product.brand}`,
};

export default function MembershipPage() {
    return <MembershipManager />;
}
