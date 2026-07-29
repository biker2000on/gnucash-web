import { redirect } from 'next/navigation';

export default function CashDetailsPage() {
  redirect('/investments?view=cash');
}
