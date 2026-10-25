CREATE TYPE "public"."perk_rule" AS ENUM('connected', 'connected_days', 'connected_apps', 'manual');--> statement-breakpoint
CREATE TABLE "perk_grants" (
	"perk_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "perk_grants_perk_id_user_id_pk" PRIMARY KEY("perk_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "perks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"rule" "perk_rule" NOT NULL,
	"threshold" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"client_id" text,
	"ip" "inet",
	"user_agent" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "perk_grants" ADD CONSTRAINT "perk_grants_perk_id_perks_id_fk" FOREIGN KEY ("perk_id") REFERENCES "public"."perks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perk_grants" ADD CONSTRAINT "perk_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perks" ADD CONSTRAINT "perks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "perks_slug_key" ON "perks" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "perks_client_idx" ON "perks" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "security_events_user_time_idx" ON "security_events" USING btree ("user_id","created_at");