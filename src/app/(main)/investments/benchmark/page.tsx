import { redirect } from 'next/navigation';

export default function BenchmarkPage() {
  redirect('/investments?view=benchmark');
}
