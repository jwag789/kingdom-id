output "issuer" {
  value = "https://${var.issuer_domain}"
}

output "relay_sns_topic_arn" {
  value = aws_sns_topic.relay.arn
}

output "run_cli" {
  description = "How to run the kingdom CLI inside a running task."
  value       = "aws ecs execute-command --cluster ${aws_ecs_cluster.main.name} --task <task-id> --container kingdom-id --interactive --command \"node dist/cli/bin.js help\""
}
