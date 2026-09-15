-- CreateTable
CREATE TABLE "client_hosts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "label" TEXT,
    "spiffe_uri" TEXT NOT NULL,
    "last_serial" TEXT,
    "last_issued_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_hosts_spiffe_uri_key" ON "client_hosts"("spiffe_uri");

-- CreateIndex
CREATE INDEX "client_hosts_workspace_id_idx" ON "client_hosts"("workspace_id");

-- AddForeignKey
ALTER TABLE "client_hosts" ADD CONSTRAINT "client_hosts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_hosts" ADD CONSTRAINT "client_hosts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
