resource "random_string" "acr_suffix" {
  length  = 5
  special = false
  upper   = false
}

resource "azurerm_container_registry" "acr" {
  name                = "${var.project_name}acr${random_string.acr_suffix.result}"
  resource_group_name = azurerm_resource_group.data.name
  location            = azurerm_resource_group.data.location
  sku                 = var.acr_sku
  admin_enabled       = false
  tags                = var.tags
}
