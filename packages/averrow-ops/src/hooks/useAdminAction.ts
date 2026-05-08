import { useState } from 'react';
import { api } from '@/lib/api';

export function useAdminAction(endpoint: string, onSuccess?: () => void) {
  const [state, setState] = useState<
    'idle' | 'confirming' | 'loading' | 'success' | 'error'
  >('idle');
  const [error, setError] = useState('');

  const execute = async () => {
    setState('loading');
    try {
      const res = await api.post(endpoint);
      if (res.error) throw new Error(res.error);
      setState('success');
      onSuccess?.();
      setTimeout(() => setState('idle'), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
      setTimeout(() => setState('idle'), 5000);
    }
  };

  return {
    state,
    error,
    confirm: () => setState('confirming'),
    cancel: () => setState('idle'),
    execute,
  };
}
