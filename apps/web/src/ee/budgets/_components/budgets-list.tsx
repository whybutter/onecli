"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { Badge } from "@onecli/ui/components/badge";
import type { BudgetListRow } from "@/lib/api/budgets";
import { isBudgetPeriod } from "@/lib/api/budgets";
import { BudgetUsageBar } from "./budget-usage-bar";
import { BudgetRowActions } from "./budget-row-actions";

export interface BudgetsListProps {
  budgets: BudgetListRow[];
}

export const BudgetsList = ({ budgets }: BudgetsListProps) => {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Secret</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Period</TableHead>
            <TableHead>Usage</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {budgets.map((b) => (
            <TableRow key={b.id}>
              <TableCell className="font-medium">{b.secretName}</TableCell>
              <TableCell>
                <Badge variant="secondary">{b.secretType}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground capitalize">
                {b.period}
              </TableCell>
              <TableCell>
                <BudgetUsageBar
                  spentCents={b.spentCents}
                  limitCents={b.limitCents}
                  period={isBudgetPeriod(b.period) ? b.period : "monthly"}
                />
              </TableCell>
              <TableCell>
                <BudgetRowActions budget={b} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
