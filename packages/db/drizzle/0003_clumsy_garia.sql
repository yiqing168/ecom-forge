ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_amount_direction" CHECK ((
        "credit_ledger"."type" not in ('reservation_freeze', 'consume') or "credit_ledger"."amount" < 0
      ) and (
        "credit_ledger"."type" <> 'release' or "credit_ledger"."amount" > 0
      ));