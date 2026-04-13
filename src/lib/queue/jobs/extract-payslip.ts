import { Job } from 'bullmq';

export async function handleExtractPayslip(job: Job): Promise<void> {
  const { payslipId, bookGuid } = job.data as { payslipId: number; bookGuid?: string };
  const { runPayslipExtraction } = await import('@/lib/payslip-extract-core');
  await runPayslipExtraction(payslipId, bookGuid, `[Job ${job.id}]`);
}
