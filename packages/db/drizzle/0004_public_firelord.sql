ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_amount_direction";--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_amount_direction" CHECK ((
        "credit_ledger"."type" not in ('reservation_freeze', 'consume', 'expiry') or "credit_ledger"."amount" < 0
      ) and (
        "credit_ledger"."type" not in ('grant', 'release', 'appeal_refund') or "credit_ledger"."amount" > 0
      ) and (
        "credit_ledger"."type" <> 'manual_correction' or "credit_ledger"."amount" <> 0
      ));