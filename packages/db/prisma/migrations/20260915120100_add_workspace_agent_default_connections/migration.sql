-- CreateTable
CREATE TABLE "workspace_agent_default_connections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "allow" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ask" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resources" JSONB,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_agent_default_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_agent_default_connections_workspace_id_idx" ON "workspace_agent_default_connections"("workspace_id");

-- CreateIndex
CREATE INDEX "workspace_agent_default_connections_connection_id_idx" ON "workspace_agent_default_connections"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_agent_default_connections_workspace_id_connection_key" ON "workspace_agent_default_connections"("workspace_id", "connection_id");

-- AddForeignKey
ALTER TABLE "workspace_agent_default_connections" ADD CONSTRAINT "workspace_agent_default_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_agent_default_connections" ADD CONSTRAINT "workspace_agent_default_connections_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_agent_default_connections" ADD CONSTRAINT "workspace_agent_default_connections_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
