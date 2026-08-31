resource "azurerm_resource_group" "dataa" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_virtual_network" "vnett" {
  name                = "${var.project_name}-vnett"
  location            = azurerm_resource_group.data.location
  resource_group_name  = azurerm_resource_group.data.name
  address_space       = var.vnet_address_space
}

resource "azurerm_subnet" "aks_subnett" {
  name                 = "${var.project_name}-aks-subnett"
  resource_group_name  = azurerm_resource_group.data.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = var.aks_subnet_prefix
}

resource "azurerm_subnet" "db_subnett" {
  name                 = "${var.project_name}-db-subnett"
  resource_group_name  = azurerm_resource_group.data.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = var.db_subnet_prefix

  delegation {
    name = "mysql-delegationn"
    service_delegation {
      name    = "Microsoft.DBforMySQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_private_dns_zone" "mysql_dnss" {
  name                = "${var.project_name}.mysql.database.azure.com"
  resource_group_name = azurerm_resource_group.data.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "mysql_dns_linkk" {
  name                  = "${var.project_name}-mysql-dns-linkk"
  resource_group_name   = azurerm_resource_group.dataa.name
  private_dns_zone_name = azurerm_private_dns_zone.mysql_dnss.name
  virtual_network_id    = azurerm_virtual_network.vnett.id
}
