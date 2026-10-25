variable "region" {
  description = "AWS region. Must support SES email receiving (e.g. us-east-1, us-west-2, eu-west-1)."
  type        = string
  default     = "us-east-1"
}

variable "zone_name" {
  description = "Route 53 hosted zone that owns the domains below, e.g. kingdomwebbuilders.com."
  type        = string
}

variable "issuer_domain" {
  description = "Where Kingdom ID is served, e.g. id.kingdomwebbuilders.com. Becomes the OIDC issuer."
  type        = string
}

variable "relay_domain" {
  description = "Domain for private relay addresses, e.g. relay.kingdomwebbuilders.com."
  type        = string
}

variable "image" {
  description = "Container image to run, e.g. ghcr.io/jwag789/kingdom-id:v1.0.0 (built by the release workflow)."
  type        = string
}

variable "desired_count" {
  description = "Kingdom ID tasks. Two or more: the API is stateless and every task runs an event consumer."
  type        = number
  default     = 2
}

variable "task_cpu" {
  type    = number
  default = 512
}

variable "task_memory" {
  type    = number
  default = 1024
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "dmarc_report_address" {
  description = "Where DMARC aggregate reports for the relay domain go."
  type        = string
}
