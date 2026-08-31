output "resource_group_name" {
  value = azurerm_resource_group.dataa.name
}

output "aks_cluster_name" {
  value = azurerm_kubernetes_cluster.aks.name
}

output "acr_login_server" {
  value = azurerm_container_registry.acr.login_server
}

output "acr_name" {
  value = azurerm_container_registry.acr.name
}

output "mysql_fqdn" {
  value = azurerm_mysql_flexible_server.mysql.fqdn
}

output "db_name" {
  value = var.db_name
}

output "mysql_admin_username" {
  value = azurerm_mysql_flexible_server.mysql.administrator_login
}

output "mysql_admin_password" {
  value = var.mysql_admin_password
}

output "get_credentials_command" {
  value = "az aks get-credentials --resource-group ${azurerm_resource_group.data.name} --name ${azurerm_kubernetes_cluster.aks.name}"
}
