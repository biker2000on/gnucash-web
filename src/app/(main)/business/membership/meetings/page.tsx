import { MeetingsManager } from '@/components/membership/MeetingsManager';
import { product } from '@/lib/product';

export const metadata = {
    title: `Meetings - ${product.brand}`,
};

export default function MeetingsPage() {
    return <MeetingsManager />;
}
