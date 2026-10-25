# The SES side of the email relay. See docs/email-relay.md for why each record exists.

data "aws_caller_identity" "current" {}

resource "aws_sesv2_email_identity" "relay" {
  email_identity = var.relay_domain
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "relay_dkim" {
  count   = 3
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${aws_sesv2_email_identity.relay.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.relay_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.relay.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "relay" {
  email_identity         = aws_sesv2_email_identity.relay.email_identity
  mail_from_domain       = "bounce.${var.relay_domain}"
  behavior_on_mx_failure = "REJECT_MESSAGE"
}

resource "aws_route53_record" "relay_mx" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.relay_domain
  type    = "MX"
  ttl     = 300
  records = ["10 inbound-smtp.${var.region}.amazonaws.com"]
}

resource "aws_route53_record" "relay_spf" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.relay_domain
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 -all"]
}

resource "aws_route53_record" "bounce_mx" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "bounce.${var.relay_domain}"
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

resource "aws_route53_record" "bounce_spf" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "bounce.${var.relay_domain}"
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com -all"]
}

resource "aws_route53_record" "relay_dmarc" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "_dmarc.${var.relay_domain}"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1; p=reject; adkim=s; aspf=r; rua=mailto:${var.dmarc_report_address}"]
}

# ---------------------------------------------------------------- Inbound

resource "aws_s3_bucket" "inbound" {
  bucket_prefix = "kingdom-relay-inbound-"
}

resource "aws_s3_bucket_public_access_block" "inbound" {
  bucket                  = aws_s3_bucket.inbound.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    id     = "expire-raw-mail"
    status = "Enabled"
    filter {}
    expiration {
      days = 7
    }
  }
}

data "aws_iam_policy_document" "inbound" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.inbound.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  policy = data.aws_iam_policy_document.inbound.json
}

resource "aws_sns_topic" "relay" {
  name = "kingdom-relay"
}

# Kingdom ID confirms this subscription itself (only for this topic, only via an SNS-hosted URL).
resource "aws_sns_topic_subscription" "relay" {
  topic_arn              = aws_sns_topic.relay.arn
  protocol               = "https"
  endpoint               = "https://${var.issuer_domain}/relay/sns"
  endpoint_auto_confirms = true
}

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = "kingdom-id"
}

resource "aws_ses_receipt_rule" "relay" {
  name          = "relay"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = [var.relay_domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"
  s3_action {
    bucket_name = aws_s3_bucket.inbound.id
    topic_arn   = aws_sns_topic.relay.arn
    position    = 1
  }
  depends_on = [aws_s3_bucket_policy.inbound]
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}
