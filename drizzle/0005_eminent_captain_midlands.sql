CREATE TABLE "routing_request_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"ok" boolean NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "routing_request_log" ADD CONSTRAINT "routing_request_log_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_request_log" ADD CONSTRAINT "routing_request_log_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routing_request_log_provider_idx" ON "routing_request_log" USING btree ("provider","ok");