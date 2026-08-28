resource "azurerm_mysql_flexible_server" "mysql" {
  name                   = "${var.project_name}-mysql"
  resource_group_name    = azurerm_resource_group.data.name
  location               = azurerm_resource_group.data.location
  administrator_login    = var.mysql_admin_username
  administrator_password = var.mysql_admin_password
  backup_retention_days  = 7
  delegated_subnet_id    = azurerm_subnet.db_subnet.id
  private_dns_zone_id    = azurerm_private_dns_zone.mysql_dns.id
  sku_name               = var.mysql_sku_name
  version                = var.mysql_version

  storage {
    size_gb = floor(var.mysql_storage_mb / 1024)
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.mysql_dns_link]

  tags = var.tags

  lifecycle {
    ignore_changes = [zone]
  }
}

resource "azurerm_mysql_flexible_database" "cards_db" {
  name                = "cards_db"
  resource_group_name = azurerm_resource_group.data.name
  server_name         = azurerm_mysql_flexible_server.mysql.name
  charset             = "utf8mb4"
  collation           = "utf8mb4_unicode_ci"
}

resource "azurerm_mysql_flexible_database" "transactions_db" {
  name                = "transactions_db"
  resource_group_name = azurerm_resource_group.data.name
  server_name         = azurerm_mysql_flexible_server.mysql.name
  charset             = "utf8mb4"
  collation           = "utf8mb4_unicode_ci"
}

resource "azurerm_mysql_flexible_database" "loans_db" {
  name                = "loans_db"
  resource_group_name = azurerm_resource_group.data.name
  server_name         = azurerm_mysql_flexible_server.mysql.name
  charset             = "utf8mb4"
  collation           = "utf8mb4_unicode_ci"
}
