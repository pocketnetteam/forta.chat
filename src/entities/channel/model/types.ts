export interface ChannelPost {
  txid: string
  type: 'video' | 'share' | 'article'
  caption: string
  message: string
  time: number
  height: number
  scoreSum: number
  scoreCnt: number
  comments: number
  images?: string[]
  url?: string
  tags?: string[]
  settings?: { v?: string }
}

export interface Channel {
  address: string
  name: string
  avatar: string
  lastContent: ChannelPost | null
}
