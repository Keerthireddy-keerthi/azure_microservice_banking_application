variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
  default     = "dev-veera-narni"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "centralindia"
}

variable "project_name" {
  description = "Prefix used for naming resources"
  type        = string
  default     = "bankingapp"
}

variable "vnet_address_space" {
  type    = list(string)
  default = ["10.10.0.0/16"]
}

variable "aks_subnet_prefix" {
  type    = list(string)
  default = ["10.10.1.0/24"]
}

variable "db_subnet_prefix" {
  type    = list(string)
  default = ["10.10.2.0/24"]
}

variable "aks_node_count" {
  type    = number
  default = 2
}

variable "aks_vm_size" {
  type    = string
  default = "Standard_B2s"
}

variable "mysql_admin_username" {
  type    = string
  default = "bankadmin"
}

variable "mysql_admin_password" {
  description = "Admin password for Azure MySQL Flexible Server"
  type        = string
  default     = "Veera@2024#Cloud"
}

variable "mysql_sku_name" {
  description = "Azure MySQL Flexible Server SKU"
  type        = string
  default     = "B_Standard_B1ms"
}

variable "mysql_storage_mb" {
  type    = number
  default = 20480
}

variable "mysql_version" {
  type    = string
  default = "8.0.21"
}

variable "acr_sku" {
  type    = string
  default = "Standard"
}


