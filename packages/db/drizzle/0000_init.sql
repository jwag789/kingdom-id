CREATE TYPE "public"."client_type" AS ENUM('confidential', 'public');--> statement-breakpoint
CREATE TYPE "public"."key_status" AS ENUM('next', 'active', 'retiring', 'retired');--> statement-breakpoint
CREATE TYPE "public"."signing_alg" AS ENUM('RS256', 'ES256');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('public', 'pairwise');--> statement-breakpoint
CREATE TYPE "public"."token_endpoint_auth_method" AS ENUM('client_secret_basic', 'client_secret_post', 'none');--> statement-breakpoint
CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"logo_uri" text,
	"type" "client_type" NOT NULL,
	"secret_hash" text,
	"token_endpoint_auth_method" "token_endpoint_auth_method" NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"allowed_scopes" text[] NOT NULL,
	"subject_type" "subject_type" DEFAULT 'pairwise' NOT NULL,
	"sector_identifier" text NOT NULL,
	"id_token_signed_response_alg" "signing_alg" DEFAULT 'RS256' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_user_id_client_id_pk" PRIMARY KEY("user_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"auth_time" timestamp with time zone NOT NULL,
	"amr" text[] NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"alg" "signing_alg" NOT NULL,
	"status" "key_status" NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_jwk_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retiring_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consents_client_subject_key" ON "consents" USING btree ("client_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_one_active_per_alg" ON "signing_keys" USING btree ("alg") WHERE "signing_keys"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_one_next_per_alg" ON "signing_keys" USING btree ("alg") WHERE "signing_keys"."status" = 'next';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");