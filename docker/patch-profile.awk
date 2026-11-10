# Adds "avoid footpaths" to a stock BRouter bike profile:
# footways, pedestrian areas and foot-designated paths that aren't signed for bikes cost
# at least 6x (normally ~1-1.5x), so they're only used as short links where nothing else goes through.
/^---context:global/ && !g {
  print
  print "assign avoid_footpaths = true # %avoid_footpaths% | Strongly avoid footpaths that are not signed for bikes | boolean"
  g = 1; next
}
/^assign +costfactor([ =]|$)/ && !c { sub(/costfactor/, "costfactor_base"); c = 1 }
/^---context:node/ && !n {
  print "assign is_footpath = and ( or highway=footway|pedestrian ( and highway=path foot=designated ) ) not bicycle=designated"
  print "assign costfactor = if ( and avoid_footpaths is_footpath ) then ( max 6 ( multiply costfactor_base 3 ) ) else costfactor_base"
  print ""
  print; n = 1; next
}
{ print }
END { if (!g || !c || !n) { print "patch-profile: missing anchor in " FILENAME > "/dev/stderr"; exit 1 } }
