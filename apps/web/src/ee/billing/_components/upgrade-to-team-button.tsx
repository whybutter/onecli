export interface UpgradeToTeamButtonProps {
  label?: string;
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
}

/**
 * Billing is dropped in this build — there is no "Team" plan to upgrade to
 * (`isPlanAtLeast` always reports the top plan), so `workspace-card.tsx`'s
 * non-team branch is never reached. Null stand-in kept only for compilation.
 */
export const UpgradeToTeamButton = ({}: UpgradeToTeamButtonProps) => null;
