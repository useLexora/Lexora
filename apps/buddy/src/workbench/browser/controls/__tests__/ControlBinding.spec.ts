import { expect, it } from 'vitest'
import { ControlBinding } from '../ControlBinding'

it('accepts only a visible enabled control and an option from the current model revision', () => {
  let visible = true
  let selected = 'low'
  const binding = new ControlBinding(() => visible, value => selected = value)
  const state = { value: 'low', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }], disabled: false }
  binding.update('model-a', state)
  const original = binding.snapshot.value.revision
  binding.update('model-a', state)
  expect(binding.snapshot.value.revision).toBe(original)
  expect(binding.propose({ revision: original, value: 'unsupported' })).toBe(false)
  expect(selected).toBe('low')
  visible = false
  expect(binding.propose({ revision: original, value: 'high' })).toBe(false)
  visible = true
  binding.update('model-b', state)
  expect(binding.propose({ revision: original, value: 'high' })).toBe(false)
  const current = binding.snapshot.value.revision
  expect(binding.propose({ revision: current, value: 'high' })).toBe(true)
  expect(selected).toBe('high')
  expect(binding.propose({ revision: current, value: 'low' })).toBe(false)
  binding.update('model-b', { ...state, disabled: true })
  expect(binding.propose({ revision: binding.snapshot.value.revision, value: 'low' })).toBe(false)
  expect(selected).toBe('high')
  expect(Object.keys(binding.snapshot.value).sort()).toEqual(['disabled', 'options', 'revision', 'value'])
})
