import { Suspense } from "react";
import { BudgetsContent } from "@/ee/budgets/_components/budgets-content";

export default function OrgBudgetsPage() {
  return (
    <Suspense>
      <BudgetsContent />
    </Suspense>
  );
}
