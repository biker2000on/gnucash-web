export const ACTION_CENTER_UPDATED_EVENT = 'gnucash-web:action-center-updated';
const ACTION_CENTER_CHANNEL = 'gnucash-web:action-center';

export function notifyActionCenterUpdated(reason: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ACTION_CENTER_UPDATED_EVENT, {
    detail: { reason },
  }));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(ACTION_CENTER_CHANNEL);
    channel.postMessage({ reason });
    channel.close();
  }
}

export function subscribeToActionCenterUpdates(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  window.addEventListener(ACTION_CENTER_UPDATED_EVENT, callback);
  const channel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(ACTION_CENTER_CHANNEL)
    : null;
  channel?.addEventListener('message', callback);

  return () => {
    window.removeEventListener(ACTION_CENTER_UPDATED_EVENT, callback);
    channel?.removeEventListener('message', callback);
    channel?.close();
  };
}
