import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { createRoom, getRoom } from './queue-actions'

export const actions: Record<string, ActionHandler<Env>> = {
  createRoom,
  getRoom,
}
