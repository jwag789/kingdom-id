terraform {
  required_version = ">= 1.9"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Configure a remote backend (S3 + lock table) before using this for real:
  # backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "kingdom-id", ManagedBy = "terraform" }
  }
}
