import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getPreference } from '@/lib/user-preferences';

export default async function Home() {
  const session = await getSession();
  const homeScreen = session.userId
    ? await getPreference(session.userId, 'home_screen', 'dashboard')
    : 'dashboard';

  redirect(homeScreen === 'accounts' ? '/accounts' : '/dashboard');
}
