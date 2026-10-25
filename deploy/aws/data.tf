# ---------------------------------------------------------------- Postgres

resource "random_password" "db" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = "kingdom-id"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_db_instance" "main" {
  identifier                   = "kingdom-id"
  engine                       = "postgres"
  engine_version               = "17"
  instance_class               = var.db_instance_class
  allocated_storage            = 20
  max_allocated_storage        = 200
  storage_encrypted            = true
  db_name                      = "kingdom_id"
  username                     = "kingdom"
  password                     = random_password.db.result
  db_subnet_group_name         = aws_db_subnet_group.main.name
  vpc_security_group_ids       = [aws_security_group.data.id]
  multi_az                     = var.db_multi_az
  backup_retention_period      = 14
  deletion_protection          = true
  skip_final_snapshot          = false
  final_snapshot_identifier    = "kingdom-id-final"
  performance_insights_enabled = true
  # Connections must use TLS.
  parameter_group_name = aws_db_parameter_group.main.name
}

resource "aws_db_parameter_group" "main" {
  name   = "kingdom-id-pg17"
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

# ---------------------------------------------------------------- Redis

resource "random_password" "redis" {
  length  = 48
  special = false
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "kingdom-id"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = "kingdom-id"
  description                = "Kingdom ID: codes, interactions, rate limits, security event stream"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.data.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
}

# ---------------------------------------------------------------- Secrets

resource "random_bytes" "key_encryption_key" {
  length = 32
}

resource "random_bytes" "server_secret" {
  length = 32
}

locals {
  secrets = {
    DATABASE_URL       = "postgres://kingdom:${random_password.db.result}@${aws_db_instance.main.address}:5432/kingdom_id?sslmode=require"
    REDIS_URL          = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
    KEY_ENCRYPTION_KEY = random_bytes.key_encryption_key.base64
    SERVER_SECRET      = random_bytes.server_secret.base64
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.secrets
  name     = "kingdom-id/${each.key}"
  # Losing KEY_ENCRYPTION_KEY makes every signing key unreadable; give deletes a long fuse.
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each      = local.secrets
  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = each.value
}
