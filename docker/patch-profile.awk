# Turns a stock BRouter bike profile into a Cycle Planner profile with extra settings,
# each overridable per request as profile:<name>=<value>:
#   avoid_footpaths  footways, pedestrian areas and foot-only paths not signed for bikes
#                    cost at least 6x, so they're only used as short links
#   turn_penalty     extra cost (metres) added to every turn, for fewer turns
#   signal_penalty   extra cost (metres) at traffic lights; a third of it at stop/give way
#   heat_strength    prefer roads that are popular on the ride heatmap: a road nobody rides costs
#                    (1 + heat_strength) times the busiest. Needs the patched BRouter
#                    (docker/brouter-heat); stock BRouter ignores it. 0 = off.
/^---context:global/ && !g {
  print
  print "assign avoid_footpaths = true # %avoid_footpaths% | Strongly avoid footpaths that are not signed for bikes | boolean"
  print "assign turn_penalty = 0 # %turn_penalty% | Extra cost per turn, in metres | number"
  print "assign signal_penalty = 0 # %signal_penalty% | Extra cost per traffic light, in metres | number"
  print "assign heat_strength = 0 # %heat_strength% | Prefer popular roads (ride heatmap): 0 off, 1 = unridden roads cost double | number"
  g = 1; next
}
/^---context:way/ { ctx = "way" }
/^---context:node/ {
  if (!n) {
    print "assign is_footpath = and ( or highway=footway|pedestrian ( and highway=path foot=designated ) ) not bicycle=designated"
    print "assign costfactor = if ( and avoid_footpaths is_footpath ) then ( max 6 ( multiply costfactor_base 3 ) ) else costfactor_base"
    print "assign turncost = add turncost_base turn_penalty"
    print ""
    n = 1
  }
  ctx = "node"
}
ctx == "way" && /^assign +costfactor( |=|$)/ && !c { sub(/costfactor/, "costfactor_base"); c = 1 }
ctx == "way" && /^assign +turncost( |=|$)/ && !t { sub(/turncost/, "turncost_base"); t = 1 }
ctx == "node" && /^assign +initialcost( |=|$)/ && !i { sub(/initialcost/, "initialcost_base"); i = 1 }
{ print }
END {
  if (!g || !c || !t || !n || !i) { print "patch-profile: missing anchor in " FILENAME > "/dev/stderr"; exit 1 }
  print ""
  print "assign is_signal = or highway=traffic_signals crossing=traffic_signals"
  print "assign initialcost = add initialcost_base ( if is_signal then signal_penalty else if highway=stop|give_way then multiply signal_penalty 0.33 else 0 )"
}
