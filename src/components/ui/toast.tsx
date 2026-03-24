import * as React from 'react'
import * as ToastPrimitive from '@radix-ui/react-toast'

import { cn } from '../../lib/utils'

export type ToastMessage = {
  id: string
  title: string
  description: string
  tone: 'success' | 'warning' | 'error' | 'info'
}

export function ToastProvider({ children }: React.PropsWithChildren) {
  return <ToastPrimitive.Provider swipeDirection="right">{children}</ToastPrimitive.Provider>
}

export function ToastViewport() {
  return <ToastPrimitive.Viewport className="ui-toast-viewport" />
}

export function Toast({
  message,
  open,
  onOpenChange,
}: {
  message: ToastMessage
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <ToastPrimitive.Root
      open={open}
      onOpenChange={onOpenChange}
      duration={3500}
      className={cn('ui-toast', `ui-toast-${message.tone}`)}
    >
      <ToastPrimitive.Title className="ui-toast-title">{message.title}</ToastPrimitive.Title>
      <ToastPrimitive.Description className="ui-toast-description">
        {message.description}
      </ToastPrimitive.Description>
    </ToastPrimitive.Root>
  )
}
