export const CREDIT_PACKAGE_NAME = '@ecom-forge/credit' as const;

export { CreditError, CreditProjectionDriftError } from './credit-errors.js';
export {
  applyConsume,
  applyFreeze,
  applyRefund,
  applyRelease,
  lockCreditAccount,
  type CreditWriteContext,
  type LockedCreditAccount,
} from './credit-account.js';
export {
  consumeReservationInTransaction,
  freezeReservation,
  freezeReservationInTransaction,
  releaseOutcomeUnknownReservationInTransaction,
  releaseReservationInTransaction,
  type CreditMutationResult,
  type FreezeInput,
  type OutcomeUnknownReleaseInput,
  type SettlementInput,
} from './reservation.js';
export {
  refundAppeal,
  refundAppealInTransaction,
  type AppealRefundInput,
  type AppealRefundResult,
} from './refund.js';
export {
  refundAppealByAdminInTransaction,
  type AdminAppealRefundInput,
  type AdminAppealRefundResult,
} from './admin-appeal-refund.js';
export {
  applyAdminManualCorrectionInTransaction,
  type AdminManualCorrectionInput,
  type AdminManualCorrectionResult,
} from './admin-manual-correction.js';

export {
  grantRegistrationCredits,
  grantRegistrationCreditsInTransaction,
  RewardCampaignGrantError,
  type RegistrationCreditGrantInput,
  type RegistrationCreditGrantResult,
} from './registration-grant.js';
export {
  submitRunQuote,
  type QuoteSubmissionEvidence,
  type QuoteSubmissionResult,
  type QuoteSubmitPorts,
} from './quote-submit.js';
export {
  releaseWorkflowCancellation,
  releaseWorkflowCancellationInTransaction,
  type WorkflowCancellationReleaseInput,
  type WorkflowCancellationReleaseResult,
} from './workflow-cancel.js';
