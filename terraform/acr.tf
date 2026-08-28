resource "azurerm_container_registry" "acr" {
  name                = "${var.project_name}veeraacr"
  resource_group_name = azurerm_resource_group.data.name
  location            = azurerm_resource_group.data.location
  sku                 = var.acr_sku
  admin_enabled       = false
}
