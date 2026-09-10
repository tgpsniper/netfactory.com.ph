-- Overrides for the outgoing subscriber email/SMS templates.
-- A row here REPLACES the hardcoded default for that (channel, template_key);
-- delete the row and the code default comes back. Deliberately NOT in
-- schema.prisma — see the header there. prisma generate only, never db push.
CREATE TABLE IF NOT EXISTS message_templates (
  id           serial PRIMARY KEY,
  channel      varchar(10)  NOT NULL CHECK (channel IN ('email','sms')),
  template_key varchar(60)  NOT NULL,
  -- Email only. NULL means "keep the default subject".
  subject      text,
  -- SMS: the whole message. Email: the body content only — the branded header,
  -- footer and company details are still applied live around it at send time.
  body         text         NOT NULL,
  enabled      boolean      NOT NULL DEFAULT true,
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  updated_by   integer,
  UNIQUE (channel, template_key)
);
