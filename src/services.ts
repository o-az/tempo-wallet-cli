import { emit, type GlobalOptions } from '#output.ts'

const servicesApiUrl = 'https://mpp.sh/api/services'

type ServiceRegistry = {
  services: Service[]
}

type Service = {
  id: string
  name: string
  url: string
  serviceUrl?: string | undefined
  service_url?: string | undefined
  description?: string | undefined
  categories?: string[] | undefined
  tags?: string[] | undefined
  docs?: ServiceDocs | undefined
  endpoints?: Array<Endpoint> | undefined
}

type ServiceDocs = {
  homepage?: string | undefined
  llmsTxt?: string | undefined
  llms_txt?: string | undefined
  openapi?: string | undefined
  apiReference?: string | undefined
  api_reference?: string | undefined
}

type Endpoint = {
  method: string
  path: string
  description?: string | undefined
  payment?: EndpointPayment | undefined
  docs?: string | undefined
}

type EndpointPayment = {
  intent: string
  amount?: string | undefined
  decimals?: number | undefined
  unitType?: string | undefined
  unit_type?: string | undefined
  description?: string | undefined
  dynamic?: boolean | undefined
}

export async function services(
  globals: GlobalOptions,
  args: { serviceId?: string | undefined; search?: string | undefined }
) {
  const registry = await fetchServices()
  const serviceId = args.serviceId === 'list' ? undefined : args.serviceId
  if (serviceId) {
    const service = registry.services.find(
      service => service.id.toLowerCase() === serviceId.trim().toLowerCase()
    )
    if (!service) throw new Error(`service '${serviceId}' not found`)
    return renderServiceDetail(globals, service)
  }
  renderServiceList(globals, registry.services, args.search)
}

async function fetchServices(): Promise<ServiceRegistry> {
  const response = await fetch(process.env.TEMPO_SERVICES_URL ?? servicesApiUrl, {
    headers: { 'user-agent': 'tempo-wallet-ts/0.0.0' }
  })
  if (!response.ok)
    throw new Error(
      `fetch service directory failed with HTTP ${response.status}: ${await response.text()}`
    )
  return (await response.json()) as ServiceRegistry
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
  if (globals.format !== 'text') return emit(globals.format, response, () => undefined)
  if (response.length === 0) {
    process.stdout.write('No services found.\n')
    return
  }
  process.stdout.write(renderServiceTable(response))
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
  if (globals.format !== 'text') return emit(globals.format, detail, () => undefined)
  process.stdout.write(renderServiceDetailText(service))
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
