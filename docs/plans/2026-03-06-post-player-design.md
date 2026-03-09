# Post Player - Design Document

## Summary

Full-featured post player for bastyon-chat: inline video playback in post cards + modal viewer with star ratings, comments, boost/donate, sharing, and author profiles. Uses Vue 3 UI with Pocketnet SDK for blockchain operations.

## Approach: Hybrid (Vue UI + SDK calls)

Vue components for presentation, Pocketnet SDK (`pSDK`, `Actions`, `Api`, `sdk`) for all blockchain operations (upvote, comments, boost). Reuses existing `use-wallet.ts` for donations.

## Architecture

```
src/features/post-player/
  index.ts                    # barrel export
  model/
    use-post.ts               # load post data, author info, caching
    use-post-scores.ts        # get scores, submit upvote via SDK
    use-post-comments.ts      # load comments, submit comment via SDK
    use-post-boost.ts         # donate PKOIN to post author via wallet
  ui/
    PostCard.vue              # enhanced inline card (replaces PostEmbed)
    PostPlayerModal.vue       # fullscreen modal viewer
    VideoPlayer.vue           # iframe player for YouTube/Vimeo/PeerTube
    StarRating.vue            # interactive 1-5 star component
    PostComments.vue          # comment list + write form
    PostActions.vue           # action bar: stars, share, boost
    PostAuthor.vue            # author row with avatar + profile link
```

## Data Flow

1. PostCard shows preview, inline video, compact star average
2. Click opens PostPlayerModal
3. Modal loads full data via composables
4. All blockchain ops go through global `window.Actions`, `window.pSDK`, `window.Api`

## SDK Integration

### Load Post (existing)
```
Api.rpc('getrawtransactionwithmessagebyid', [[txid]]) -> BastyonPostData
```

### Star Ratings (new)
```
sdk.postscores.get(txid) -> scores[] {address, value}
sdk.likes.get([txid]) -> myVal
sdk.upvote.checkvalue(value) -> ok
share.upvote(value) -> upvoteShare
Actions.addActionAndSendIfCan(upvoteShare) -> tx
```

### Comments (new)
```
Api.rpc('getcomments', [{postid: txid}]) -> comments[]
Actions.comment({postid, msg, parentid?}) -> tx
```

### Boost/Donate (reuse use-wallet.ts)
```
useWallet().sendTransfer(authorAddress, amount)
```

### Share to Chat
Forward `bastyon://post?s=<txid>` as message using existing forwarding logic.

## Caching
- Posts: existing `postCache` Map
- Scores: in-memory Map<txid, scores[]>, 5 min TTL
- Comments: in-memory, invalidate after own submission

## UI Layout

### PostCard (inline)
- Current PostEmbed + embedded iframe video player
- Compact bar: avg rating, comment count, "Open" button
- Click -> modal

### PostPlayerModal
- Video player / image gallery (top)
- Author row with avatar + [Boost PKOIN] button
- Full title and text
- Tags
- Interactive star rating (1-5) with score count
- [Share to chat] button
- Comments section with pagination (20 per page)
- Comment input + submit

### StarRating
- Hover highlights stars up to cursor
- Click submits rating with confirmation animation
- Already rated: shows my rating, disabled
- Theme-adaptive colors

### VideoPlayer
- YouTube/Vimeo/PeerTube via iframe embed
- 16:9 aspect ratio
- Fallback to thumbnail + link on error

## Error Handling

- SDK unavailable: readonly mode, interactions disabled with tooltip
- Scam criteria: dialog warning (matches Bastyon behavior)
- Upvote block criteria: restriction message
- Own post: stars hidden
- Empty comments: "No comments yet" placeholder
- Comment submit error: toast, text preserved in input
- Video iframe failure: fallback to thumbnail + external link
- Boost: reuses DonateModal balance check logic

## i18n Keys Needed
- `postPlayer.stars`, `postPlayer.comments`, `postPlayer.boost`
- `postPlayer.shareToChat`, `postPlayer.writeComment`
- `postPlayer.noComments`, `postPlayer.loadMore`
- `postPlayer.rated`, `postPlayer.ratingRestricted`
- `postPlayer.boostAuthor`, `postPlayer.sendComment`
