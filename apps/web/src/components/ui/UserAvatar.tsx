'use client'

import { useState } from 'react'

interface UserAvatarProps {
  src?:   string | null
  name?:  string | null
  email?: string | null
  size?:  number
  style?: React.CSSProperties
}

/** Returns a deterministic HSL color from any string */
function hashColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  const h = Math.abs(hash) % 360
  return `hsl(${h}, 55%, 42%)`
}

function getInitials(name?: string | null, email?: string | null): string {
  const src = name?.trim() || email?.split('@')[0] || '?'
  const parts = src.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

export function UserAvatar({ src, name, email, size = 32, style }: UserAvatarProps) {
  const [imgFailed, setImgFailed] = useState(false)

  const initials   = getInitials(name, email)
  const colorSeed  = name || email || '?'
  const bgColor    = hashColor(colorSeed)
  const fontSize   = size <= 28 ? Math.round(size * 0.42) : Math.round(size * 0.38)

  const base: React.CSSProperties = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0, ...style,
  }

  if (src && !imgFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name ?? email ?? ''}
        width={size}
        height={size}
        onError={() => setImgFailed(true)}
        style={{ ...base, objectFit: 'cover' }}
      />
    )
  }

  return (
    <div style={{
      ...base,
      background: bgColor,
      color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize, fontWeight: 600, letterSpacing: '0.02em',
      userSelect: 'none',
    }}>
      {initials}
    </div>
  )
}
