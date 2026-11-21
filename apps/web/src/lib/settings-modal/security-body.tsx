import GroupsPage from "@/ee/groups/groups-page";
import OrgDomainsPage from "@/ee/settings/org-domains-page";

export const SecurityBody = () => (
  <div className="flex flex-1 flex-col gap-10">
    <OrgDomainsPage />
    <GroupsPage />
  </div>
);
