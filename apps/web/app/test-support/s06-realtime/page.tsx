import { notFound } from 'next/navigation';

import { RealtimeLiveHarness } from '@/features/realtime/realtime-live-harness';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function S06RealtimeTestPage({
  searchParams,
}: {
  searchParams: Promise<{ workflow_run_id?: string | string[] }>;
}) {
  const query = await searchParams;
  const workflowRunId = query.workflow_run_id;
  if (
    process.env.APP_ENV !== 'local' ||
    process.env.S06_LIVE_E2E !== '1' ||
    typeof workflowRunId !== 'string' ||
    !UUID_PATTERN.test(workflowRunId)
  ) {
    notFound();
  }
  return <RealtimeLiveHarness workflowRunId={workflowRunId} />;
}
