import { useState, useCallback } from 'react';

/**
 * useJobProgress — small hook that wraps the JobProgressModal lifecycle.
 *
 * Usage:
 *   const { runWithProgress, modalProps } = useJobProgress();
 *   await runWithProgress({
 *     title: 'Syncing contacts…',
 *     fn: async (jobId) => api(path, { method: 'POST', headers: { 'X-Job-Id': jobId }, body }),
 *   });
 *   // <JobProgressModal {...modalProps} />
 *
 * The fn receives a jobId already wired into the modal. Send it as X-Job-Id
 * so the backend updates the same in-memory job the modal is polling.
 */
export function useJobProgress() {
  const [jobId, setJobId] = useState(null);
  const [title, setTitle] = useState('Working…');

  const runWithProgress = useCallback(async ({ title: t, fn }) => {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    setTitle(t || 'Working…');
    setJobId(id);
    try {
      return await fn(id);
    } catch (err) {
      // Modal stays open showing the error from the job tracker.
      // Caller can decide to close via modalProps.onClose.
      throw err;
    }
  }, []);

  const close = useCallback(() => setJobId(null), []);

  return {
    runWithProgress,
    modalProps: { jobId, title, onClose: close },
  };
}
