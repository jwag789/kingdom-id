data "aws_route53_zone" "main" {
  name = var.zone_name
}

# ---------------------------------------------------------------- TLS

resource "aws_acm_certificate" "issuer" {
  domain_name       = var.issuer_domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "issuer_validation" {
  for_each = { for o in aws_acm_certificate.issuer.domain_validation_options : o.domain_name => o }
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  records  = [each.value.resource_record_value]
  ttl      = 300
}

resource "aws_acm_certificate_validation" "issuer" {
  certificate_arn         = aws_acm_certificate.issuer.arn
  validation_record_fqdns = [for r in aws_route53_record.issuer_validation : r.fqdn]
}

# ---------------------------------------------------------------- Load balancer

resource "aws_lb" "main" {
  name                       = "kingdom-id"
  load_balancer_type         = "application"
  subnets                    = module.vpc.public_subnets
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "app" {
  name        = "kingdom-id"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = module.vpc.vpc_id
  # No stickiness: any task can serve any request.
  health_check {
    path                = "/readyz"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 10
  }
  deregistration_delay = 20
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.issuer.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_route53_record" "issuer" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.issuer_domain
  type    = "A"
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# ---------------------------------------------------------------- ECS

resource "aws_ecs_cluster" "main" {
  name = "kingdom-id"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/kingdom-id/app"
  retention_in_days = 30
}

locals {
  environment = {
    NODE_ENV            = "production"
    PORT                = "4000"
    ISSUER              = "https://${var.issuer_domain}"
    TRUST_PROXY         = "true"
    LOG_LEVEL           = "info"
    EMAIL_RELAY_ENABLED = "true"
    RELAY_DOMAIN        = var.relay_domain
    RELAY_TRANSPORT     = "ses"
    RELAY_SNS_TOPIC_ARN = aws_sns_topic.relay.arn
    AWS_REGION          = var.region
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "kingdom-id"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name                   = "kingdom-id"
    image                  = var.image
    essential              = true
    portMappings           = [{ containerPort = 4000, protocol = "tcp" }]
    environment            = [for k, v in local.environment : { name = k, value = v }]
    secrets                = [for k, s in aws_secretsmanager_secret.app : { name = k, valueFrom = s.arn }]
    readonlyRootFilesystem = true
    healthCheck = {
      command     = ["CMD", "wget", "-qO-", "http://127.0.0.1:4000/readyz"]
      interval    = 10
      timeout     = 3
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "app"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name            = "kingdom-id"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  # Lets operators run the `kingdom` CLI inside a task (see docs/deploy.md).
  enable_execute_command = true

  network_configuration {
    subnets         = module.vpc.private_subnets
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "kingdom-id"
    container_port   = 4000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  # The release workflow updates the image; Terraform shouldn't roll it back.
  lifecycle {
    ignore_changes = [task_definition]
  }
  depends_on = [aws_lb_listener.https]
}
