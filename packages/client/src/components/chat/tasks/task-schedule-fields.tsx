import { Combobox } from '@/components/ui/combobox'
import { Select } from '@/components/ui/select'
import moment from 'moment-timezone'
import { useId } from 'react'

export const fieldStyle = 'grid gap-1.5 text-sm font-medium'

const timeZones = moment.tz.names()
const menuWidth = 'w-max min-w-(--anchor-width) max-w-[calc(100dvw-2rem)]'

type ScheduleSelectProps<Value extends string> = {
  label: string
  items: readonly { value: Value; label: string }[]
  value: Value
  onChange: (value: Value) => void
}

export function ScheduleSelect<Value extends string>({
  label,
  items,
  value,
  onChange,
}: ScheduleSelectProps<Value>) {
  const id = useId()

  return (
    <div className={fieldStyle}>
      <label htmlFor={id}>{label}</label>
      <Select<Value>
        items={items}
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next)
        }}
      >
        <Select.Trigger id={id} variant="input" className="h-11 w-full">
          <Select.Value />
        </Select.Trigger>
        <Select.Content className={menuWidth}>
          <Select.Group>
            {items.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                <span className="whitespace-normal">{item.label}</span>
              </Select.Item>
            ))}
          </Select.Group>
        </Select.Content>
      </Select>
    </div>
  )
}

type TimeZoneFieldProps = {
  value: string
  onChange: (zone: string) => void
}

export function TimeZoneField({ value, onChange }: TimeZoneFieldProps) {
  const id = useId()

  return (
    <div className={fieldStyle}>
      <label htmlFor={id}>Time zone</label>
      <Combobox value={value} onValueChange={onChange} noDeselect>
        <Combobox.Trigger id={id} aria-required="true" className="h-11">
          <Combobox.DisplayValue label={value} />
        </Combobox.Trigger>
        <Combobox.Content className={menuWidth}>
          <Combobox.Search
            aria-label="Search time zones"
            placeholder="Search time zones…"
          />
          <Combobox.List className="max-h-52">
            <Combobox.Empty>No matching time zones.</Combobox.Empty>
            <Combobox.Group>
              {timeZones.map((zone) => (
                <Combobox.Item key={zone} value={zone} searchText={zone}>
                  {zone}
                </Combobox.Item>
              ))}
            </Combobox.Group>
          </Combobox.List>
        </Combobox.Content>
      </Combobox>
    </div>
  )
}
