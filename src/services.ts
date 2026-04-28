import { z } from 'incur'

import { shouldRenderText, type GlobalOptions } from '#output.ts'

const servicesApiUrl = 'https://mpp.sh/api/services'

const endpointPaymentSchema = z.object({
  intent: z.string(),
  amount: z.string().optional(),
  decimals: z.number().optional(),
  unitType: z.string().optional(),
  unit_type: z.string().optional(),
  description: z.string().optional(),
  dynamic: z.boolean().optional()
})

const endpointSchema = z.object({
  method: z.string(),
  path: z.string(),
  description: z.string().optional(),
  payment: endpointPaymentSchema.optional(),
  docs: z.string().optional()
})

const serviceDocsSchema = z.object({
  homepage: z.string().optional(),
  llmsTxt: z.string().optional(),
  llms_txt: z.string().optional(),
  openapi: z.string().optional(),
  apiReference: z.string().optional(),
  api_reference: z.string().optional()
})

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  serviceUrl: z.string().optional(),
  service_url: z.string().optional(),
  description: z.string().optional(),
  categories: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  docs: serviceDocsSchema.optional(),
  endpoints: z.array(endpointSchema).optional()
})

const serviceRegistrySchema = z.object({
  services: z.array(serviceSchema)
})

type ServiceRegistry = z.infer<typeof serviceRegistrySchema>
type Service = z.infer<typeof serviceSchema>
type EndpointPayment = z.infer<typeof endpointPaymentSchema>

export const servicesArgs = z.object({
  serviceId: z.string().optional().describe('Service ID to show details for')
})

export const servicesOptions = z.object({
  search: z.string().optional().describe('Search by name, description, tags, or category')
})

type ServicesContext = {
  args: z.infer<typeof servicesArgs>
  options: z.infer<typeof servicesOptions>
}

export async function services(globals: GlobalOptions, c: ServicesContext) {
  const registry = await fetchServices(globals)
  const serviceId = c.args.serviceId === 'list' ? undefined : c.args.serviceId
  if (serviceId) {
    const service = registry.services.find(
      service => service.id.toLowerCase() === serviceId.trim().toLowerCase()
    )
    if (!service) throw new Error(`service '${serviceId}' not found`)
    return renderServiceDetail(globals, service)
  }
  return renderServiceList(globals, registry.services, c.options.search)
}

async function fetchServices(globals: GlobalOptions): Promise<ServiceRegistry> {
  const response = await fetch(globals.env.TEMPO_SERVICES_URL ?? servicesApiUrl, {
    headers: { 'user-agent': 'tempo-wallet-ts/0.0.0' }
  })
  if (!response.ok)
    throw new Error(
      `fetch service directory failed with HTTP ${response.status}: ${await response.text()}`
    )
  return serviceRegistrySchema.parse(await response.json())
}

function renderServiceList(
  globals: GlobalOptions,
  services: Service[],
  search: string | undefined
) {
  const filtered = filterServices(services, search)
  const response = filtered.map(service => ({
    id: service.id,
    name: service.name,
    url: service.url,
    service_url: service.serviceUrl ?? service.service_url,
    description: service.description,
    categories: service.categories ?? [],
    tags: service.tags ?? [],
    endpoint_count: service.endpoints?.length ?? 0
  }))
  if (!shouldRenderText(globals)) return response
  if (response.length === 0) {
    process.stdout.write('No services found.\n')
    return undefined
  }
  process.stdout.write(renderServiceTable(response))
  return undefined
}

function renderServiceDetail(globals: GlobalOptions, service: Service) {
  const detail = {
    id: service.id,
    name: service.name,
    url: service.url,
    service_url: service.serviceUrl ?? service.service_url,
    description: service.description,
    categories: service.categories ?? [],
    tags: service.tags ?? [],
    docs: service.docs,
    endpoints: (service.endpoints ?? []).map(endpoint => ({
      method: endpoint.method.toUpperCase(),
      path: endpoint.path,
      description: endpoint.description,
      payment: endpoint.payment,
      docs: endpoint.docs
    }))
  }
  if (!shouldRenderText(globals)) return detail
  process.stdout.write(renderServiceDetailText(service))
  return undefined
}

function filterServices(services: Service[], search: string | undefined) {
  const query = search?.trim().toLowerCase()
  if (!query) return services
  return services.filter(service =>
    [
      service.id,
      service.name,
      service.description,
      ...(service.categories ?? []),
      ...(service.tags ?? [])
    ]
      .filter(value => typeof value === 'string')
      .some(value => value.toLowerCase().includes(query))
  )
}

function renderServiceTable(
  services: { categories: string[]; id: string; name: string; service_url?: string | undefined }[]
) {
  const idWidth = widthFor(
    services.map(service => service.id),
    2,
    20
  )
  const nameWidth = widthFor(
    services.map(service => service.name),
    4,
    24
  )
  const categoryWidth = widthFor(
    services.map(service => service.categories.join(', ') || '-'),
    8,
    16
  )
  const lines = [
    `  ${'ID'.padEnd(idWidth)}  ${'Name'.padEnd(nameWidth)}  ${'Category'.padEnd(categoryWidth)}  Service URL`,
    `  ${'-'.repeat(2 + idWidth + 2 + nameWidth + 2 + categoryWidth + 2 + 30)}`
  ]
  for (const service of services) {
    const category = service.categories.join(', ') || '-'
    lines.push(
      `  ${truncate(service.id, idWidth).padEnd(idWidth)}  ${truncate(service.name, nameWidth).padEnd(nameWidth)}  ${truncate(category, categoryWidth).padEnd(categoryWidth)}  ${service.service_url ?? '-'}`
    )
  }
  lines.push('', `${services.length} service(s).`)
  return `${lines.join('\n')}\n`
}

function renderServiceDetailText(service: Service) {
  const lines = [service.name, '-'.repeat(service.name.length)]
  if (service.description) lines.push(service.description)
  lines.push('')
  lines.push(field('ID', service.id))
  lines.push(field('Categories', (service.categories ?? []).join(', ') || '-'))
  lines.push(field('Service URL', service.serviceUrl ?? service.service_url ?? '-'))
  lines.push(field('Upstream URL', service.url))
  if ((service.tags ?? []).length > 0) lines.push(field('Tags', service.tags!.join(', ')))
  if ((service.endpoints ?? []).length > 0) {
    lines.push('', 'Endpoints:')
    for (const endpoint of service.endpoints!) {
      lines.push(
        `  ${endpoint.method.toUpperCase().padStart(6)} ${endpoint.path.padEnd(40)} ${formatPricing(endpoint.payment)}`
      )
      const description = endpoint.description ?? endpoint.payment?.description
      if (description) lines.push(`         ${description}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function field(label: string, value: string) {
  return `${label.padStart(14)}: ${value}`
}

function formatPricing(payment: EndpointPayment | undefined) {
  if (!payment) return 'free'
  if (payment.dynamic) return `dynamic ${payment.intent}`
  if (payment.amount) return `${formatAmount(payment.amount, payment.decimals)} ${payment.intent}`
  return payment.intent
}

function formatAmount(amount: string, decimals: number | undefined) {
  if (!decimals) return amount
  const padded = amount.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const fraction = padded.slice(-decimals)
  return `$${whole}.${fraction}`
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function widthFor(values: string[], min: number, max: number) {
  return Math.min(max, Math.max(min, ...values.map(value => value.length)))
}
