package main

import (
	"fmt"
	"strings"
)

// args is a tiny GNU-style parser: flags may appear anywhere, --flag value, --flag=value,
// short aliases, repeatable flags. (The standard flag package stops at the first positional.)
type args struct {
	pos   []string
	vals  map[string][]string
	bools map[string]bool
}

var shortAlias = map[string]string{"s": "status", "t": "title", "d": "detail", "n": "note", "l": "link", "p": "purpose", "h": "help"}
var boolFlags = map[string]bool{"all": true, "json": true, "help": true, "adopt": true}

func parseArgs(in []string) (*args, error) {
	a := &args{vals: map[string][]string{}, bools: map[string]bool{}}
	for i := 0; i < len(in); i++ {
		s := in[i]
		if s == "--" {
			a.pos = append(a.pos, in[i+1:]...)
			break
		}
		if !strings.HasPrefix(s, "-") || s == "-" {
			a.pos = append(a.pos, s)
			continue
		}
		name := strings.TrimLeft(s, "-")
		var val *string
		if k, v, ok := strings.Cut(name, "="); ok {
			name, val = k, &v
		}
		if full, ok := shortAlias[name]; ok && !strings.HasPrefix(s, "--") {
			name = full
		}
		if boolFlags[name] {
			a.bools[name] = true
			continue
		}
		if val == nil {
			if i+1 >= len(in) {
				return nil, fmt.Errorf("--%s needs a value", name)
			}
			i++
			v := in[i]
			val = &v
		}
		a.vals[name] = append(a.vals[name], *val)
	}
	return a, nil
}

// get returns the last value of a flag and whether it was given.
func (a *args) get(name string) (string, bool) {
	v := a.vals[name]
	if len(v) == 0 {
		return "", false
	}
	return v[len(v)-1], true
}

func (a *args) str(name string) string { v, _ := a.get(name); return v }
