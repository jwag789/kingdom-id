CREATE TYPE "public"."mask_status" AS ENUM('active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TABLE "masks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"address" text NOT NULL,
	"status" "mask_status" DEFAULT 'active' NOT NULL,
	"forwarded_count" bigint DEFAULT 0 NOT NULL,
	"blocked_count" bigint DEFAULT 0 NOT NULL,
	"last_forwarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reverse_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mask_id" uuid NOT NULL,
	"correspondent" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "masks" ADD CONSTRAINT "masks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "masks" ADD CONSTRAINT "masks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reverse_aliases" ADD CONSTRAINT "reverse_aliases_mask_id_masks_id_fk" FOREIGN KEY ("mask_id") REFERENCES "public"."masks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "masks_address_key" ON "masks" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "masks_one_live_per_app" ON "masks" USING btree ("user_id","client_id") WHERE "masks"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "reverse_aliases_address_key" ON "reverse_aliases" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "reverse_aliases_pair_key" ON "reverse_aliases" USING btree ("mask_id","correspondent");